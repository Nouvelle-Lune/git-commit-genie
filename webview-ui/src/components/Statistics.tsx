import React from 'react';
import './Statistics.css';

interface StatisticsProps {
    todayCount: number;
    totalCount: number;
    i18n: {
        title: string;
        todayLabel: string;
        totalLabel: string;
    };
}

export const Statistics: React.FC<StatisticsProps> = ({ todayCount, totalCount, i18n }) => {
    return (
        <div className="section">
            <h3>{i18n.title}</h3>
            <div className="stats">
                <div className="stat-item">
                    <span className="stat-label">{i18n.todayLabel}</span>
                    <span className="stat-value">{todayCount}</span>
                </div>
                <div className="stat-item">
                    <span className="stat-label">{i18n.totalLabel}</span>
                    <span className="stat-value">{totalCount}</span>
                </div>
            </div>
        </div>
    );
};
